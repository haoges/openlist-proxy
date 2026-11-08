/**
 * EdgeOne Makers adapter.
 * Route all paths through edge-functions/[[default]].js.
 */
import worker from "../openlist-proxy.js";

export default async function onRequest(context) {
  return worker.fetch(context.request, context.env || {}, context);
}
