// Empty fs shim for browser - pst-extractor uses Buffer path, not fs
export function openSync() { return -1 }
export function readSync() { return 0 }
export function closeSync() {}
export function statSync() { return { size: 0 } }
export default { openSync, readSync, closeSync, statSync }
