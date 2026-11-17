import type { IntegrationsResponse } from "../shared/integrations.ts";
import { integrationList } from "./herdr/client.ts";
import { badRequest, errorResponse, jsonResponse, setRequestRoute } from "./http.ts";

export async function handleIntegrationsRequest(request: Request, pathname: string): Promise<Response | null> {
  if (pathname === "/api/integrations") {
    setRequestRoute(pathname);
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    try {
      return jsonResponse({ integrations: await integrationList() } satisfies IntegrationsResponse);
    } catch (error) {
      return errorResponse(error);
    }
  }
  return null;
}
