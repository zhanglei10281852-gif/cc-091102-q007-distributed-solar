export const requestStates = ['submitted', 'negotiating', 'window-held', 'approved', 'cancelled'];
const requestCache = new Map();

export function cacheRequest(request) {
  requestCache.set(request.requestId, request);
}

export function getRequest(context, requestId) {
  const item = requestCache.get(requestId);
  if (!item) return null;
  return item;
}

export function findTopicOverlap(allRequests, topicCodes) {
  return allRequests.filter(item => item.topicCodes?.some(code => topicCodes.includes(code)));
}
