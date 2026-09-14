// Copy text to the clipboard. navigator.clipboard exists only in a secure
// context (https or localhost); a dashboard served over plain http on the
// LAN, as Umbrel's is, has none, so fall back to a hidden textarea and
// document.execCommand("copy"). Returns false when copying is not possible.
export function copyToClipboard(text) {
  const value = String(text == null ? "" : text);
  try {
    if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
      // Asynchronous; fall back if the browser refuses (permissions, focus).
      navigator.clipboard.writeText(value).catch(() => execCopy(value));
      return true;
    }
  } catch (e) {
    // Fall through to execCommand.
  }
  return execCopy(value);
}

function execCopy(value) {
  try {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-9999px";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, value.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch (e) {
    return false;
  }
}
