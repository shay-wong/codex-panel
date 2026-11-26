// 浏览器内执行的原生权限/模型适配函数。
function customProviderUltrafastAccess(hostId, provider, access, model) {
  // 未配置提供商时沿用 Codex 的 OpenAI 默认值；空白和非法值仍不扩展权限。
  provider ??= "openai";
  const supported = /^(?:gpt-6[- ]astra|gpt-6\.1[- ]sol|gpt-6\.2[- ](?:astra|sol))$/i.test(model);
  return hostId === "local" && typeof provider === "string" && provider.trim() !== ""
    ? { ...access, fast: supported || access?.fast === true, ultrafast: supported }
    : access;
}
