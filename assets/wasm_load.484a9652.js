// loadSnglWasm fetches the playground WASM and returns its bytes. docsgen
// ships it gzipped, since uncompressed it is over GitHub's 100 MiB file limit,
// so the bytes are inflated here. A server that already set Content-Encoding
// hands over plain WASM, which is told apart by gzip's magic number.
async function loadSnglWasm(url) {
    const resp = await fetch(url);
    if (!resp.ok) {
        throw new Error(`fetching ${url}: ${resp.status} ${resp.statusText}`);
    }
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
        return bytes;
    }
    const inflated = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(inflated).arrayBuffer();
}
