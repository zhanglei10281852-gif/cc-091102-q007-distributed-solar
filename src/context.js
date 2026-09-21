// 访问者与作用域传播：县级用户绑定县域（可选绑定运营商），省级管理员不绑定任何县域。
export const roles = Object.freeze({
  COUNTY_USER: 'county-user',
  PROVINCE_ADMIN: 'province-admin',
});

export function createActor({ id, role, tenant = null, operator = null } = {}) {
  if (!id || typeof id !== 'string') throw new Error('访问者缺少 id');
  if (!Object.values(roles).includes(role)) throw new Error(`未知角色: ${role}`);
  if (role === roles.COUNTY_USER && !tenant) throw new Error('县级用户必须绑定县域');
  if (role === roles.PROVINCE_ADMIN && (tenant || operator)) {
    throw new Error('省级管理员不得绑定县域或运营商');
  }
  return Object.freeze({ id, role, tenant, operator });
}
