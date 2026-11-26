// 浏览器内执行的原生权限/模型适配函数。
function withUltrafastTier(model) {
  if (!model) return model;
  const missing = [{ id: "priority", name: "Fast", description: "" }, { id: "ultrafast", name: "Ultrafast", description: "" }]
    .filter(tier => !model.serviceTiers?.some(existing => existing.id === tier.id));
  return missing.length ? { ...model, serviceTiers: [...(model.serviceTiers ?? []), ...missing] } : model;
}
