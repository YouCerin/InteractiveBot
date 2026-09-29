/**
 * 扩展服务：把"技能 + 插件"的**开关与设置**做成一组可被 HTTP/CLI 调用的动作（0.2.2）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它为什么存在（与 /api/config 的分工）
 * ══════════════════════════════════════════════════════════════════════════
 * `/api/config` 是"改配置 → **重启**生效"那条老路：它只写盘，活配置对象不动。
 * 而技能/插件的开关必须是**随时开关**（用户明确要求），所以这里走另一条路：
 *
 *     写盘（持久化）  +  改**活配置对象**（立刻生效）
 *
 * 两者都做，缺一不可：
 *   · 只写盘 → 界面显示"已保存"，实际这一轮还在用旧值（本项目最忌讳的那种"说了做不到"）；
 *   · 只改内存 → 重启就丢，用户以为已经关了。
 *
 * ── 即时生效到底"即时"到什么程度（如实划边界）────────────────────────────
 *   · **技能提示词片段**：下一轮就变（桥接每轮现读 config）；
 *   · **技能工具**：被关掉之后**调用会被当场拒绝**（MCP 侧每次调用现读 config.json）；
 *   · **插件**：看 `src/plugins.mjs` 里每个插件标了 `hot` 还是 `cold`（都附了取证位置），
 *     `cold` 的那些**如实返回 `restartRequired: true`** —— 界面据此提示，而不是假装生效了；
 *   · **装卸技能**：要重启桥接（工具表与 profile 是启动时定的）。这条写在界面文案里。
 */

import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import {
  mergeSkillSettings,
  mergeSkillSettingsPatch,
  redactSkillSettings,
  callSkillDiagnose,
  describeSkill,
} from './extensions.mjs'
import { listPlugins, pluginById, pluginSwitchKind, readPath } from './plugins.mjs'

/* ── 点分路径读写（配置补丁要按 `a.b.c` 落键）───────────────────────────── */

function setPath(obj, path, value) {
  const parts = String(path).split('.')
  let cur = obj
  for (const part of parts.slice(0, -1)) {
    if (cur[part] === null || typeof cur[part] !== 'object') cur[part] = {}
    cur = cur[part]
  }
  cur[parts[parts.length - 1]] = value
  return obj
}

/**
 * @param {object} opts
 * @param {object} opts.config        **活配置对象**（会被就地修改 —— 这就是"即时生效"）
 * @param {string} opts.configPath    config.json 的绝对路径
 * @param {object[]} opts.skills      已发现的技能（`src/extensions.mjs` 的 discoverSkills）
 * @param {string} opts.skillsDir     技能目录（给界面显示"技能从哪来"）
 * @param {Function} [opts.log]
 * @param {Function} [opts.validate]  配置校验（默认从 config.mjs 取，便于测试注入）
 * @param {Function} [opts.normalize]
 */
export function createExtensionService({
  config,
  configPath,
  skills = [],
  skillsDir = '',
  log = () => {},
  validate,
  normalize,
} = {}) {
  const findSkill = (id) => skills.find((s) => s.id === String(id)) ?? null

  const readRaw = () => JSON.parse(readFileSync(configPath, 'utf8'))

  /**
   * 落盘前**先跑一遍与启动时完全相同的校验**。
   *
   * ★ 为什么不能"先写再说"：这里改的是配置，而配置写坏了机器人是**起不来**的
   *   （例如把 `dsh.workspace` 顺手改空）。宁可拒绝这次开关，也不要留下一个
   *   下次启动必失败的文件 —— 而且用户没有任何提示。
   */
  function persist(raw) {
    const check = validate && normalize ? validate(normalize(raw)) : { fatal: [] }
    if (check.fatal?.length > 0) {
      const error = new Error('这次改动会让配置无法启动，已拒绝')
      error.fatal = check.fatal
      throw error
    }
    try {
      copyFileSync(configPath, `${configPath}.bak`)
    } catch {
      /* 备份失败不阻断保存（与 /api/config 一致） */
    }
    writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
  }

  /** 列表：技能卡片 + 插件卡片 + 一句"现在的总体状况"。 */
  function list() {
    const skillCards = skills.map((s) => describeSkill(s, config))
    const pluginCards = listPlugins({ config })
    const enabledSkills = skillCards.filter((s) => s.enabled).length
    const brokenSkills = skillCards.filter((s) => !s.ready && s.errors.length > 0).length
    const onPlugins = pluginCards.filter((p) => p.enabled === true).length
    return {
      skillsDir,
      skills: skillCards,
      plugins: pluginCards,
      counts: {
        skills: skillCards.length,
        skillsEnabled: enabledSkills,
        skillsBroken: brokenSkills,
        plugins: pluginCards.length,
        pluginsOn: onPlugins,
      },
      // 这几句是**给界面直接显示**的（不是给开发者看的）：界面照抄即可，不用再编一遍。
      notes: [
        '开关是**即时生效**的：技能关掉后提示词立刻不再提它，工具调用会被当场拒绝。',
        '**装/卸技能要重启桥接**（工具表与 profile 是启动时定的）—— 把技能目录拷进 skills/ 或删掉之后重启即可。',
        '标了「要重启」的插件，是因为那段代码只在启动时读一次配置（每个都给得出取证位置）。',
      ],
    }
  }

  /**
   * 开/关一个技能或插件。
   *
   * @returns {Promise<object>} 成功返回 `{ type, id, enabled, hot, restartRequired, hint }`；
   *   失败返回 `{ error, status }`（路由层据此回 4xx —— 错误码区分"没这个东西"与"不能这么改"）
   */
  async function toggle({ type, id, enabled } = {}) {
    if (type === 'skill') {
      const skill = findSkill(id)
      if (!skill) return { error: `没有这个技能：${id}`, status: 404 }
      if (!skill.ok) {
        return {
          error: `「${skill.name}」装不上，先修它的 skill.json：${skill.errors.join('；')}`,
          status: 422,
          extra: { errors: skill.errors },
        }
      }
      if (skill.loadError) {
        return { error: `「${skill.name}」加载失败，开不了：${skill.loadError}`, status: 422 }
      }
      let raw
      try {
        raw = readRaw()
        raw.skills = raw.skills && typeof raw.skills === 'object' ? raw.skills : {}
        raw.skills[id] = { ...(raw.skills[id] ?? {}), enabled }
        persist(raw)
      } catch (error) {
        return { error: error.message, status: 422, extra: error.fatal ? { fatal: error.fatal } : {} }
      }
      // ★ 活配置就地改：这就是"下一轮就生效"的全部秘密
      config.skills = config.skills && typeof config.skills === 'object' ? config.skills : {}
      config.skills[id] = { ...(config.skills[id] ?? {}), enabled }
      return {
        type,
        id,
        enabled,
        hot: true,
        restartRequired: false,
        hint: enabled
          ? `已打开「${skill.name}」。它下一轮就会出现在提示词里（不需要重启）。`
          : `已关闭「${skill.name}」。提示词里立刻不再提它，工具调用会被当场拒绝。`,
      }
    }

    if (type === 'plugin') {
      const plugin = pluginById(id)
      if (!plugin) return { error: `没有这个插件：${id}`, status: 404 }
      const kind = pluginSwitchKind(plugin)
      if (kind.kind === 'list') {
        // "名单"没有"关"这个动作：清单为空本身就是安全状态，把它说成开关会误导人。
        return {
          error: `${plugin.name}没有"开关"：它是名单/权限，请在对应页签里逐项维护。`,
          status: 400,
        }
      }
      // ★★ 0.2.7：控件在**技能卡**上的条目（`switchInSkill`，例如表情包）—— 这里**拒绝**。
      //
      //  为什么必须拒（不是礼貌）：同一个配置键 `skills.sticker.enabled` 已经有两条写入口
      //  （技能卡那条是正主），插件卡再渲染一个开关，界面上就出现两个都能点的控制点 ——
      //  真机反馈过："同一个开关放在 skill 和插件上不合理"。
      //  这里与上面 list / choice 两条守卫是同一条纪律：**一个键只留一条写入口**。
      //  ★ 注意**不是**删除登记：`plugins.mjs` 里那一条仍然在（插件区照样能看到
      //    "表情包存在、开关在技能卡上、关掉会怎样"），只是不再提供第二个开关。
      if (kind.kind === 'skill') {
        return {
          error:
            `${plugin.name}的开关在**技能卡**上：控制台 →「扩展」→ 技能 →「${plugin.name}」→ 开关` +
            `（它默认就是技能，插件区只登记开关在哪，不提供第二个开关）。`,
          status: 400,
        }
      }
      // 二选一（`choice`，0.2.3）：**没有"开/关"这个动作** —— 它不是开关，
      // 是"选了哪一个"。
      //
      // ★ 这条守卫是**必须的，不是礼貌**：没有它，下面那行
      //   `setPath(raw, plugin.enabledPath, enabled)` 会把布尔值写进一个
      //   只认字符串的键（`wake.policy`），于是配置里出现 `"policy": true`，
      //   而运行期按"不是 semantic"处理 ⇒ **界面显示保存成功、实际什么都没发生**。
      //   这正是本项目最忌讳的"说了做不到"。
      // ★ 选择走的是 `/api/config` 的 patch 通道（写 `{wake:{policy:'semantic'}}`），
      //   与其它"需要重启"的设置同一条路 —— 不给同一个键开第二条写入口。
      if (kind.kind === 'choice') {
        return {
          error:
            `${plugin.name}是二选一，没有"开/关"：请把 ${plugin.enabledPath} 设成 ` +
            kind.options.map((o) => `「${o.value}」`).join(' 或 ') +
            '（界面上的按钮走的是改配置那条通道）。',
          status: 400,
        }
      }
      // 枚举类开关（目前只有 persona.preset）："关"= 取值 none，"开"= 回到精简档。
      // ★ 如实说明：打开时用的是**默认档**而不是"你上次用的那一档" —— 我们没有存历史档位，
      //   假装记得会让用户以为设置被保留了。要换档请到「人设」页里选。
      const value = kind.kind === 'enum' ? (enabled ? kind.onValue : kind.offValue) : enabled
      let raw
      try {
        raw = readRaw()
        setPath(raw, plugin.enabledPath, value)
        persist(raw)
      } catch (error) {
        return { error: error.message, status: 422, extra: error.fatal ? { fatal: error.fatal } : {} }
      }
      setPath(config, plugin.enabledPath, value)
      return {
        type,
        id: plugin.id,
        enabled,
        hot: plugin.hot,
        restartRequired: plugin.hot !== true,
        why: plugin.why,
        hint: plugin.hot
          ? `已${enabled ? '打开' : '关闭'}「${plugin.name}」，**立刻生效**。`
          : `已${enabled ? '打开' : '关闭'}「${plugin.name}」，但**需要重启机器人**才生效：${plugin.why}`,
      }
    }

    return { error: `type 只能是 skill 或 plugin（收到「${type}」）`, status: 400 }
  }

  /**
   * 保存某个技能的设置。
   *
   * ★ 密文字段（pixiv 的 Cookie）沿用与 `/api/config` **完全一致**的语义：
   *   空串 = 保持原值、`null` = 显式清除。两条路各写一套语义，迟早会出现
   *   "改个上限顺手把 Cookie 弄丢了"。
   */
  async function saveSettings({ id, patch } = {}) {
    const skill = findSkill(id)
    if (!skill) return { error: `没有这个技能：${id}`, status: 404 }
    if (!skill.ok) return { error: `「${skill.name}」装不上，先修它的 skill.json`, status: 422 }

    const raw = readRaw()
    const current = mergeSkillSettings(skill.manifest, raw.skills?.[id]).settings
    const withPatch = mergeSkillSettingsPatch(skill.manifest, current, patch ?? {})
    // 收敛 + 类型检查：转不了的值会带一条 warning（而不是静默变成 NaN 或默认值）
    const { settings, warnings } = mergeSkillSettings(skill.manifest, withPatch)

    raw.skills = raw.skills && typeof raw.skills === 'object' ? raw.skills : {}
    raw.skills[id] = settings
    try {
      persist(raw)
    } catch (error) {
      return { error: error.message, status: 422, extra: error.fatal ? { fatal: error.fatal } : {} }
    }
    config.skills = config.skills && typeof config.skills === 'object' ? config.skills : {}
    config.skills[id] = settings

    const { values, has } = redactSkillSettings(skill.manifest, settings)
    return {
      id,
      settings: values,
      secretSet: has,
      warnings,
      // 与 /api/config 的 restartRequired:true 形成鲜明对照 —— 这一条是**不需要重启**
      restartRequired: false,
      hint: '已保存，**立即生效**（技能每次调用都现读配置，不需要重启）。',
    }
  }

  /** 技能自诊断（技能可选导出 `diagnose(context)`）。 */
  async function diagnose(id) {
    const skill = findSkill(id)
    if (!skill || !skill.loaded) return null
    const report = callSkillDiagnose(skill, { config })
    if (!report) return null
    return { id: skill.id, name: skill.name, version: skill.version, report }
  }

  /** 这个技能此刻的某个设置值（给 CLI 打印用）。 */
  function settingOf(id, key) {
    const skill = findSkill(id)
    if (!skill) return undefined
    const { settings } = mergeSkillSettings(skill.manifest, config.skills?.[id])
    return key ? readPath(settings, key) : settings
  }

  return { list, toggle, saveSettings, diagnose, settingOf, persist }
}
