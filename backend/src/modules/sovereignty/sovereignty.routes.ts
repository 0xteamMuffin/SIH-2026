import { Router } from "express";
import { z } from "zod";
import { audit } from "../../lib/audit.js";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { describePosture, probeEgress, readEgressLedger } from "./sovereignty.service.js";

export const sovereigntyRouter = Router();

/**
 * Sovereignty evidence.
 *
 * The posture is readable by any authenticated user: it describes controls and
 * configuration, contains no operational data, and the people doing the work
 * are exactly the people who should be able to check that their material is
 * staying on-premise without asking an administrator.
 *
 * The ledger and the probe are administrator-only. The ledger spans every
 * workspace, so even though it holds no content it would let one team see when
 * another was working. The probe deliberately attempts outbound connections.
 */

sovereigntyRouter.get("/posture", authenticate, (_request, response, next) => {
  try {
    response.json(describePosture());
  } catch (error) { next(error); }
});

const ledgerQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Window to summarise over. Omit for all of recorded history. */
  sinceHours: z.coerce.number().int().min(1).max(24 * 365).optional(),
}).strict();

sovereigntyRouter.get("/egress", authenticate, requireRole("ADMIN"), async (request, response, next) => {
  try {
    const query = ledgerQuerySchema.parse(request.query);
    const ledger = await readEgressLedger({
      limit: query.limit,
      ...(query.sinceHours
        ? { since: new Date(Date.now() - query.sinceHours * 60 * 60 * 1000) }
        : {}),
    });
    response.json(ledger);
  } catch (error) { next(error); }
});

/**
 * The probe is deployment-wide, not workspace-scoped. The caller still supplies
 * the workspace it was run from, because the audit log is read per workspace —
 * an event filed with no workspace is recorded but invisible to anyone looking
 * for it, and "we proved isolation" is exactly the record an auditor needs to
 * be able to find. The metadata makes the scope explicit.
 */
const probeBodySchema = z.object({ workspaceId: z.string().uuid().optional() }).strict();

sovereigntyRouter.post("/egress-probe", authenticate, requireRole("ADMIN"), async (request, response, next) => {
  try {
    const { workspaceId } = probeBodySchema.parse(request.body ?? {});
    const result = await probeEgress();
    // The probe is itself an outbound attempt, so it is recorded. In the
    // sovereign profile that record is the evidence: an attempt was made and
    // every destination refused.
    await audit({
      actorId: request.user!.id,
      ...(workspaceId ? { workspaceId } : {}),
      eventType: "EGRESS_PROBE_RUN",
      metadata: {
        scope: "deployment",
        mode: result.mode,
        allBlocked: result.allBlocked,
        targets: result.targets.map((target) => ({
          host: target.host,
          verdict: target.verdict,
          reason: target.reason,
        })),
      },
    });
    response.json(result);
  } catch (error) { next(error); }
});
