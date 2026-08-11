function createStorage() {
  let map = new Map();
  return {
    get length() {
      return map.size;
    },
    key(i) {
      return Array.from(map.keys())[i] ?? null;
    },
    getItem(k) {
      return map.has(String(k)) ? map.get(String(k)) : null;
    },
    setItem(k, v) {
      map.set(String(k), String(v));
    },
    removeItem(k) {
      map.delete(String(k));
    },
    clear() {
      map = new Map();
    },
  };
}

for (const name of ["localStorage", "sessionStorage"]) {
  let available;
  try {
    available = globalThis[name] != null;
  } catch {
    available = false;
  }
  if (!available) {
    Object.defineProperty(globalThis, name, {
      value: createStorage(),
      configurable: true,
      writable: true,
    });
  }
}
