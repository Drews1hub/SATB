// Small built-ins that older browsers lack. PDF.js relies on Promise.withResolvers
// (Chrome 119+, Safari 17.4+), so this must load before PDF.js.
if (!Promise.withResolvers) {
  Promise.withResolvers = function () {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}
