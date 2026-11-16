const bridge = window.authProbe;
function render(state) {
  for (const [id, status] of Object.entries(state.services)) {
    document.getElementById(`${id}-origin`).textContent = status.origin ?? "Loading website…";
    const previousRun =
      status.observation.runStarted && status.observation.runStarted !== state.runStarted;
    document.querySelector(`[data-result="${id}"]`).value = previousRun
      ? "not-tested"
      : status.observation.result;
    const notes = [];
    if (status.loading) notes.push("Loading");
    if (status.loadError) notes.push(`Load error ${status.loadError}`);
    if (status.blocked) notes.push("Provider rejection detected in navigation");
    if (status.popups) notes.push(`${status.popups} auth popup(s) opened in this profile`);
    if (previousRun)
      notes.push(`Previous run: ${status.observation.result}. Check the site again after restart.`);
    if (!notes.length)
      notes.push("Result is manually observed; page loading does not prove login.");
    document.getElementById(`${id}-status`).textContent = notes.join(" · ");
  }
}
function showError() {
  document.getElementById("summary").textContent =
    "The probe action failed. Check the terminal and retry.";
}
bridge.onUpdate(render);
bridge.state().then(render).catch(showError);
document
  .querySelectorAll("[data-reload]")
  .forEach((button) =>
    button.addEventListener("click", () => document.getElementById(button.dataset.reload).reload()),
  );
document
  .querySelectorAll("[data-external]")
  .forEach((button) =>
    button.addEventListener("click", () =>
      bridge.openExternal(button.dataset.external).catch(showError),
    ),
  );
document
  .querySelectorAll("[data-result]")
  .forEach((select) =>
    select.addEventListener("change", () =>
      bridge.observe(select.dataset.result, select.value).catch(showError),
    ),
  );
document
  .getElementById("restart")
  .addEventListener("click", () => bridge.restart().catch(showError));
document.getElementById("export").addEventListener("click", () => bridge.export().catch(showError));
