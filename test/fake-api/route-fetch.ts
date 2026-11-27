// The preload of every test that starts the built server, which sends its requests only to the
// production API. Node loads it with `--import` before dist/main.js, so its fetch sends each such
// request to the local server of the test, and refuses every other URL.

const PRODUCTION_ORIGIN = 'https://apis.alfaview.com';
const LOCAL_ORIGIN = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;

const target = process.env.ALFAVIEW_FAKE_API_ORIGIN;
if (target === undefined || !LOCAL_ORIGIN.test(target)) {
  throw new Error(
    'route-fetch: ALFAVIEW_FAKE_API_ORIGIN must be the origin of the fake API, http://127.0.0.1:<port>.',
  );
}

const realFetch = globalThis.fetch;

globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== PRODUCTION_ORIGIN) {
    return Promise.reject(new TypeError(`route-fetch refused ${url.href}`));
  }
  return realFetch(`${target}${url.pathname}${url.search}`, init);
};
