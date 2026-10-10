import { NextResponse } from "next/server";
import { clearConsoleLogs, getConsoleLogs, getConsoleLogEntries, initConsoleLogCapture } from "@/lib/consoleLogBuffer";
import { getPm2Logs, getDockerLogs } from "@/lib/systemLogFetcher";

initConsoleLogCapture();

export async function GET() {
  try {
    const logs = getConsoleLogs();
    const pm2Data = getPm2Logs(250);
    const dockerData = getDockerLogs(250);

    return NextResponse.json({
      success: true,
      logs,
      // Structured view — [{time, level, line}] — so a consumer gets the level
      // the line was emitted at instead of re-parsing rendered text
      // (9router-go parity: HandleConsoleLogsGet returns log.ConsoleEntries()).
      entries: getConsoleLogEntries(),
      pm2Logs: pm2Data.combined || [],
      pm2Info: {
        available: pm2Data.available,
        errorLogFile: pm2Data.errorLogFile,
        outLogFile: pm2Data.outLogFile,
        errorCount: pm2Data.errorLogs?.length || 0,
      },
      dockerLogs: dockerData.logs || [],
      dockerInfo: {
        isDocker: dockerData.isDocker,
        available: dockerData.available,
      },
    });
  } catch (error) {
    console.error("Error getting console logs:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    clearConsoleLogs();
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error clearing console logs:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
