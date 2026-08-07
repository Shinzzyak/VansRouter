import { getConsistentMachineId } from "@/shared/utils/machineId.js";
import { verifyDashboardAuthToken } from "./dashboardSession.js";

const CLI_TOKEN_HEADER = "x-9r-cli-token";

export async function isAuthorizedDashboardRequest(request) {
  const cliToken = request.headers.get(CLI_TOKEN_HEADER);
  if (cliToken && cliToken === await getConsistentMachineId("9r-cli-auth")) return true;
  return verifyDashboardAuthToken(request.cookies.get("auth_token")?.value);
}

export async function requireDashboardAuth(request) {
  return isAuthorizedDashboardRequest(request);
}
