// Where a transaction link goes: the Mempool app the operator chose, or a
// public explorer for this chain. mempool.space follows the SHA256d chain
// and would show a transaction on this chain as missing; mempool.guide
// follows the Bitcoin BLAKE2b chain.
export const PUBLIC_EXPLORER_URL = "https://mempool.guide";
export const PUBLIC_EXPLORER_NAME = "mempool.guide";

export function txExplorerUrl(localUrl, txid) {
  return `${localUrl || PUBLIC_EXPLORER_URL}/tx/${txid}`;
}

// A public explorer learns which transactions the user looks at, so it is
// asked about first; a chosen app is the user's own.
export function confirmPublicExplorer(event, localUrl) {
  if (
    !localUrl &&
    !window.confirm(
      `This will open the transaction in a public explorer for the Bitcoin BLAKE2b chain (${PUBLIC_EXPLORER_NAME}). Do you wish to continue?`
    )
  ) {
    event.preventDefault();
  }
}
