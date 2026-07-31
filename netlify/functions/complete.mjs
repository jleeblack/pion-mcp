/**
 * POST /.netlify/functions/complete   { paymentId, txid }
 *
 * Phase 2 of a U2A payment, and the only step that proves anything. Per the
 * hostile-client warning in docs/pi-sdk-notes.md, a browser reporting success
 * is not evidence of a payment — a 200 from Pi's /complete is. So this handler
 * reports `completed: true` on exactly that and on nothing else; every other
 * outcome, including one it cannot classify, comes back as not completed.
 *
 * Also serves onIncompletePaymentFound, which is the same operation applied to
 * a payment left dangling by an earlier session.
 */

import {
  isPaymentId,
  isTxid,
  json,
  piFetch,
  precheck,
  upstreamFailure,
} from "../lib/pi.mjs";

export default async (req) => {
  const { response, key, body } = await precheck(req);
  if (response) return response;

  const { paymentId, txid } = body;
  if (!isPaymentId(paymentId)) {
    return json(400, {
      error: "bad_payment_id",
      message: "paymentId must be an identifier of up to 64 characters [A-Za-z0-9_-].",
    });
  }
  if (!isTxid(txid)) {
    // An incomplete payment with no transaction was never submitted to the
    // chain and cannot be completed — it has to be cancelled instead. Saying
    // so beats forwarding a request Pi will reject for reasons the page cannot
    // interpret.
    return json(400, {
      error: "missing_txid",
      message:
        "A blockchain txid is required to complete a payment. A payment with no " +
        "transaction was never submitted on-chain and must be cancelled, not completed.",
    });
  }

  const completed = await piFetch("POST", `/v2/payments/${paymentId}/complete`, key, { txid });
  if (!completed.ok) return upstreamFailure("complete", completed);

  // Reached only on a 200. This is the point at which the payment is real.
  return json(200, {
    completed: true,
    paymentId,
    txid,
    status: completed.data?.status ?? null,
    verified: completed.data?.transaction?.verified ?? null,
  });
};
