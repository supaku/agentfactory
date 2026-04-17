/**
 * File Reservation Delegate
 *
 * Interface for file reservation operations, injected into the code-intelligence
 * plugin by the host (orchestrator/worker). Avoids compile-time dependency on
 * the server package which provides the Redis-backed implementation.
 *
 * The host captures repoId at construction time, so agents do not need to know it.
 */

export interface FileReservationDelegate {
  /**
   * Reserve files before modifying them.
   * @returns Reserved files and any conflicts with other sessions
   */
  reserveFiles(
    sessionId: string,
    filePaths: string[],
    reason?: string,
  ): Promise<{
    reserved: string[]
    conflicts: Array<{
      filePath: string
      heldBy: { sessionId: string; reservedAt: number }
    }>
  }>

  /**
   * Check if files are reserved by other sessions (read-only).
   * Files reserved by the requesting session are NOT reported as conflicts.
   */
  checkFileConflicts(
    sessionId: string,
    filePaths: string[],
  ): Promise<
    Array<{
      filePath: string
      heldBy: { sessionId: string; reservedAt: number }
    }>
  >

  /**
   * Release file reservations after modifications are complete.
   * @returns Number of files released
   */
  releaseFiles(sessionId: string, filePaths: string[]): Promise<number>

  /**
   * Release ALL file reservations for a session.
   * Called by the orchestrator on agent completion to prevent stale reservations
   * from blocking other agents. TTL provides fallback if this call fails.
   * @returns Number of files released
   */
  releaseAllSessionFiles(sessionId: string): Promise<number>
}
