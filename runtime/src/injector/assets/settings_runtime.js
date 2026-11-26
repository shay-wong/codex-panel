function createSettingsPresentationRuntime(initialMode = 'system') {
  const normalize = value => value === 'dialog' || value === 'page' ? value : 'system';
  let mode = normalize(initialMode);
  const listeners = new Set();
  return {
    getSnapshot: () => mode,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setMode(value) {
      const next = normalize(value);
      if (next === mode) return;
      mode = next;
      for (const listener of listeners) listener();
    },
  };
}
