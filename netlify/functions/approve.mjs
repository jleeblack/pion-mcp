/**
 * POST /.netlify/functions/approve   { paymentId }
 *
 * Phase 1 of a U2A payment. The Pi Browser SDK calls onReadyForServerApproval
 * with a payment id and then waits: the payment cannot proceed until the app's
 * server approves it. Approval is the app saying "yes, I asked for this" — so
 * the server reads the payment from Pi and checks it against what this page
 * actually offered before approving anything.
 */

import {
  EXPECTED_AMOUNT,
  EXPECTED_MEMO,
  expectationProblems,
  isPaymentId,
  json,
  piFetch,
  precheck,
  upstreamFailure,
} from "../lib/pi.mjs";

export default async (req) => {
  const { response, key, body } = await precheck(req);
  if (response) return response;

  const { paymentId } = body;
  if (!isPaymentId(paymentId)) {
    return json(400, {
      error: "bad_payment_id",
      message: "paymentId must be an identifier of up to 64 characters [A-Za-z0-9_-].",
    });
  }

  // Read before writing. The client's id is a claim; this is the fact.
  const found = await piFetch("GET", `/v2/payments/${paymentId}`, key);
  if (!found.ok) return upstreamFailure("lookup", found);

  const problems = expectationProblems(found.data);
  if (problems.length > 0) {
    return json(409, {
      error: "unexpected_payment",
      message: `Refusing to approve: this is not the ${EXPECTED_AMOUNT} Test-Pi "${EXPECTED_MEMO}" payment.`,
      problems,
    });
  }

  const approved = await piFetch("POST", `/v2/payments/${paymentId}/approve`, key);
  if (!approved.ok) return upstreamFailure("approve", approved);

  return json(200, {
    approved: true,
    paymentId,
    status: approved.data?.status ?? null,
  });
};
