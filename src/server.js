import { createServer } from 'node:http';
import { createApp } from './app.js';

const PORT = Number(process.env.PORT || 8080);

// 引导令牌仅用于本地联调；生产环境由密钥管理注入，不得提交真实令牌。
const demoTokens = {
  'demo-province': { id: 'u-province', role: 'province' },
  'demo-county-a': { id: 'u-admin-a', role: 'county-admin', tenant: 'county-a' },
  'demo-county-b': { id: 'u-admin-b', role: 'county-admin', tenant: 'county-b' },
  'demo-op-a': { id: 'u-op-a', role: 'operator', tenant: 'county-a', operator: 'op-solar-1' },
};

const { handler } = createApp({ tokens: demoTokens });
createServer(handler).listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`distributed-solar-sampling listening on ${PORT}`);
});
