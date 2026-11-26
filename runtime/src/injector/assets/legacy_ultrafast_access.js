// 浏览器内执行的原生权限/模型适配函数。
function customProviderUltrafastAccess(hostId, provider, access, model) {
  // 已支持的模型同时开放快速和超快；其他模型保留原生快速权限。
  const supported = /^(?:gpt-6[- ]astra|gpt-6\.1[- ]sol|gpt-6\.2[- ](?:astra|sol))$/i.test(model);
  return hostId === "local" && typeof provider === "string" && provider !== "" && provider !== "openai"
    ? { ...access, fast: supported || access?.fast === true, ultrafast: supported }
    : access;
}
