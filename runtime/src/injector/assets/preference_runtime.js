function createCodexProviderQuotaRuntime(initialEnabled) {
  let enabled = initialEnabled === true;
  const listeners = new Set();
  return {
    installed: false,
    prepared: false,
    applied: false,
    getSnapshot: () => enabled,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setEnabled(value) {
      const next = value === true;
      if (enabled === next) return;
      enabled = next;
      for (const listener of listeners) listener();
    },
  };
}
