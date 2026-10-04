import { gbkBytes } from './fixtures/chat-dialects.mjs';
const b = gbkBytes('夹具-测试消息');
console.log('我们的字节:', b.toString('hex'));
console.log('真机字节  : bcd0bedf2db2e2cad4cffbcfa2');
console.log('一致 =', b.toString('hex') === 'bcd0bedf2db2e2cad4cffbcfa2');
