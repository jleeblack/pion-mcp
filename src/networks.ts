/**
 * Which Pi chain this server reads.
 *
 * One resolved object is the single source of truth. Everything downstream —
 * the Horizon client, the startup banner, the `network` field on every read
 * result, and the payments arming check — reads it instead of re-deriving the
 * network by sniffing a URL string.
 *
 * That is the point. Before v0.4 the network was inferred in two places by
 * testing `HORIZON_URL.includes("testnet")`: once for the banner, once for
 * arming. Two independent sniffs of one string is how a configuration ends up
 * testnet by one check and mainnet by another.
 *
 * Values below were verified against the live nodes on 2026-08-14, not assumed
 * from the naming pattern. See docs/pi-sdk-notes.md, "Layer 3".
 */

export type NetworkId = "testnet" | "mainnet" | "custom";

export interface PiNetwork {
  id: NetworkId;
  /** Horizon base URL, no trailing slash. */
  horizonUrl: string;
  /** Human-facing name, for banners and tool output. NOT a signing input. */
  label: string;
  /**
   * The Stellar network passphrase, as reported by the node itself.
   * `undefined` for a custom endpoint, whose chain identity we cannot vouch for.
   */
  passphrase: string | undefined;
  /** Block explorer base, for pointing a human at independent confirmation. */
  explorerUrl: string | undefined;
  /**
   * True only for the genuine Pi Testnet. This is the flag payments arm on;
   * nothing else may set it, including a custom endpoint that looks testnet-ish.
   */
  isTestnet: boolean;
}

export const PI_TESTNET: PiNetwork = {
  id: "testnet",
  horizonUrl: "https://api.testnet.minepi.com",
  label: "Pi Testnet",
  passphrase: "Pi Testnet",
  explorerUrl: "https://blockexplorer.minepi.com/testnet",
  isTestnet: true,
};

export const PI_MAINNET: PiNetwork = {
  id: "mainnet",
  horizonUrl: "https://api.mainnet.minepi.com",
  label: "Pi Mainnet",
  /**
   * "Pi Network" — NOT "Pi Mainnet".
   *
   * This is the one value here that the naming pattern gets wrong, and getting
   * it wrong is expensive: the passphrase is hashed into every signature, so a
   * transaction signed against the wrong string is invalid on the chain it was
   * meant for.
   *
   * Verified three ways on 2026-08-14:
   *   1. `GET https://api.mainnet.minepi.com/` reports
   *      `"network_passphrase": "Pi Network"`. For a Stellar network the node's
   *      own answer is definitive — it is the string it validates against.
   *   2. The secondary node, api2.mainnet.minepi.com, reports the same.
   *   3. The string "Pi Mainnet" *does* appear in Pi's production explorer
   *      bundle, but only as English UI copy ("...not been activated on the Pi
   *      Mainnet yet"). It is a display label that reads like corroboration and
   *      is not. Hence `label` and `passphrase` are separate fields here.
   */
  passphrase: "Pi Network",
  explorerUrl: "https://blockexplorer.minepi.com/mainnet",
  isTestnet: false,
};

/**
 * Pi publishes a secondary mainnet Horizon at https://api2.mainnet.minepi.com
 * (from `REACT_APP_MAINNET_SECONDARY_API_URL` in the explorer's production
 * build). It is live and reports the same passphrase.
 *
 * Deliberately not wired as automatic failover. Two hosts silently serving one
 * client can disagree — different ingestion lag, one stale — and a read that
 * quietly changes source is exactly the kind of thing that makes a later
 * "the balance was wrong" impossible to reconstruct. Set PION_HORIZON_URL to it
 * by hand if the primary is down.
 */
export const PI_MAINNET_SECONDARY_URL = "https://api2.mainnet.minepi.com";

const KNOWN: Record<string, PiNetwork> = {
  testnet: PI_TESTNET,
  mainnet: PI_MAINNET,
};

/** A `PION_NETWORK` / `PION_HORIZON_URL` combination we refuse to guess at. */
export class NetworkConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkConfigError";
  }
}

export interface Resolution {
  network: PiNetwork;
  /** Non-fatal note for the operator, printed at startup. */
  warning?: string;
}

/**
 * Resolves the network from the environment.
 *
 * Pure and env-injectable so the guards can be tested without mutating the
 * real process environment.
 */
export function resolveNetwork(env: NodeJS.ProcessEnv = process.env): Resolution {
  const requestedRaw = env.PION_NETWORK?.trim();
  const requested = requestedRaw?.toLowerCase();

  if (requested !== undefined && requested !== "" && KNOWN[requested] === undefined) {
    throw new NetworkConfigError(
      `PION_NETWORK must be "testnet" or "mainnet", got "${requestedRaw}". ` +
        "Refusing to start rather than guessing which chain you meant.",
    );
  }

  const selected = requested ? KNOWN[requested]! : PI_TESTNET;

  const override = env.PION_HORIZON_URL?.trim().replace(/\/+$/, "");
  if (!override) return { network: selected };

  const matched = Object.values(KNOWN).find((candidate) => candidate.horizonUrl === override);

  if (matched) {
    // Both variables are set and they name different chains. One of them is a
    // mistake and we cannot tell which, so stop instead of picking a winner.
    if (requested && matched.id !== selected.id) {
      throw new NetworkConfigError(
        `PION_NETWORK=${selected.id} and PION_HORIZON_URL=${override} name different ` +
          `networks (${selected.label} vs ${matched.label}). Set one or the other, not both.`,
      );
    }
    return { network: matched };
  }

  // An endpoint we have not verified. It may well be a proxy in front of the
  // real testnet, but we cannot confirm that from here, and "probably testnet"
  // is not a basis for arming a spend. Label it honestly as unknown.
  return {
    network: {
      id: "custom",
      horizonUrl: override,
      label: `custom endpoint (${override})`,
      passphrase: undefined,
      explorerUrl: undefined,
      isTestnet: false,
    },
    warning:
      `PION_HORIZON_URL points at ${override}, which is not a Pi network Pion knows. ` +
      "Reads will be attempted against it and reported as an unverified chain; " +
      "payments cannot be armed against a custom endpoint.",
  };
}

/**
 * Resolved once at startup. On a configuration error this falls back to testnet
 * — the safe default — and records the error for `index.ts` to report before it
 * serves anything. Throwing from module scope would surface as a bare stack
 * trace from an import, which is not a useful thing to hand an operator.
 */
let resolutionError: NetworkConfigError | undefined;
let resolved: Resolution;
try {
  resolved = resolveNetwork();
} catch (error) {
  resolutionError = error as NetworkConfigError;
  resolved = { network: PI_TESTNET };
}

export const NETWORK = resolved.network;
export const NETWORK_WARNING = resolved.warning;
export const NETWORK_ERROR = resolutionError;
