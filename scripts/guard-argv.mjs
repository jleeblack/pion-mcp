/**
 * Refuses to run when a secret appears in the command line.
 *
 * Every script here takes credentials from the environment, never as an
 * argument, because arguments land in shell history. That was a documented
 * convention until 2026-07-31, when a clipboard holding an app wallet seed was
 * pasted onto a command line instead of into a Read-Host prompt: the seed was
 * appended to a uid, went into PowerShell history, and was transmitted to the
 * Pi API as part of the request body before anything noticed.
 *
 * A convention that depends on nobody mis-pasting is not a control. This is.
 * It runs before any network call, so the worst case becomes a local mistake
 * rather than a credential in someone else's logs.
 */

/** Stellar secret seed: 56 base32 characters beginning with S. */
const SECRET_SHAPE = /S[A-Z2-7]{55}/;

/**
 * Aborts if any argument contains something shaped like a Stellar secret.
 *
 * Matches anywhere in an argument rather than anchoring, because the real
 * incident concatenated the seed onto a legitimate value rather than passing
 * it alone. Never prints the matched text.
 */
export function refuseSecretsInArgv(argv = process.argv.slice(2)) {
  const index = argv.findIndex((arg) => SECRET_SHAPE.test(arg));
  if (index === -1) return;

  console.error("REFUSING TO RUN — a command-line argument contains a Stellar secret seed.\n");
  console.error(`  Argument ${index + 1} carries 56 base32 characters beginning with S.`);
  console.error("  The value is not printed here, and no request was made.\n");
  console.error("This usually means a clipboard holding a wallet secret was pasted onto the");
  console.error("command line instead of into a prompt. Arguments reach shell history, the");
  console.error("terminal buffer, and any API this script would have called.\n");
  console.error("Treat that secret as compromised and rotate it. Then clear the history:\n");
  console.error("  Clear-History");
  console.error("  Remove-Item (Get-PSReadlineOption).HistorySavePath\n");
  console.error("Credentials belong in the environment, never in an argument:");
  console.error('  $s = Read-Host "Wallet secret" -AsSecureString');
  console.error("  $env:PI_WALLET_SECRET = [Runtime.InteropServices.Marshal]::PtrToStringAuto(");
  console.error("    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))");
  process.exit(1);
}
