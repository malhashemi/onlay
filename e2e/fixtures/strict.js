// external script (script-src 'self'); proves allowed JS still runs.
let n = 0;
const btn = document.getElementById("counter-btn");
btn.addEventListener("click", () => {
  n += 1;
  btn.textContent = `Clicked ${n} times`;
});

// Record every CSP violation the page observes so the spec can assert
// attribution: the only violation must be this page's own inline canary.
window.__cspViolations = [];
document.addEventListener("securitypolicyviolation", (e) => {
  window.__cspViolations.push({
    blockedURI: e.blockedURI,
    sourceFile: e.sourceFile,
    directive: e.effectiveDirective,
  });
});
