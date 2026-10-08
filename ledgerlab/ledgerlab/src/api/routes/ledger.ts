import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { AppContext } from "../../context.js";
import { DomainError } from "../../domain/errors.js";
import { checkInvariants } from "../../ledger/invariants.js";
import { accountBalances, getLedgerTransaction } from "../../ledger/ledger-repository.js";
import * as S from "../schemas.js";
import { ledgerTransactionJson } from "../serializers.js";

export function ledgerRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      "/ledger/transactions/:id",
      { schema: { tags: ["ledger"], summary: "A ledger transaction with its entries", params: S.IdParams, response: { 200: S.LedgerTransaction, 404: S.ErrorResponse } } },
      async (req) => {
        const t = await getLedgerTransaction(ctx.pool, req.params.id);
        if (!t) throw new DomainError("NOT_FOUND", "No such ledger transaction.");
        return ledgerTransactionJson(t);
      },
    );

    app.get("/ledger/balances", { schema: { tags: ["ledger"], summary: "Account balances derived from the journal" } }, async () => ({
      data: (await accountBalances(ctx.pool)).map((b) => ({
        account: b.code,
        currency: b.currency,
        name: b.name,
        normal_balance: b.normalBalance,
        is_memo: b.isMemo,
        debits: b.debits,
        credits: b.credits,
        balance: b.balance,
      })),
    }));

    app.get(
      "/ledger/invariants",
      { schema: { tags: ["ledger"], summary: "Run every system invariant check against the live database" } },
      async (_req, reply) => {
        const report = await checkInvariants(ctx.pool);
        return reply.code(report.ok ? 200 : 500).send(report);
      },
    );
  };
}
