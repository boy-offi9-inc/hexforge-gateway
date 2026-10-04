/**
 * Capability contract.
 *
 * A "capability" is what an adapter can DO (decompile, rebuild, instrument...),
 * independent of WHICH tool does it. An adapter describes itself with an
 * AdapterDescriptor and plugs in through the existing registerAgent seam. The
 * descriptor is optional, so every current agent and plugin keeps working
 * unchanged.
 */

/** Dotted, lowercase id, e.g. "java.decompile", "android.rebuild", "instrument.trace". */
export type CapabilityId = string;

export interface OperationSpec {
  /** Operation name as dispatched in a task, e.g. "decompile". */
  name: string;
  /** Capability this operation provides. Several adapters may provide the same one. */
  capability: CapabilityId;
  description?: string;
  /** Payload keys the operation requires / accepts (names only for now). */
  inputs?: { required?: string[]; optional?: string[] };
  /** Artifact kinds it produces, e.g. ["java-sources"]. */
  outputs?: string[];
  /** Event names it may emit while running. */
  events?: string[];
  cancellable?: boolean;
}

export interface ToolProvenance {
  tool: string;
  /** Filled in at runtime when the version can be read. */
  version?: string;
}

export interface AdapterDescriptor {
  /** Agent kind this adapter is registered under, e.g. "jadx". */
  kind: string;
  version?: string;
  description?: string;
  /** External tool(s) behind it. Backends should stay replaceable. */
  backends?: ToolProvenance[];
  operations: OperationSpec[];
  /** Coarse permissions the adapter needs, e.g. "fs:workspace", "device:adb", "network". */
  permissions?: string[];
  /** Higher wins when several adapters offer the same capability. Default 0. */
  priority?: number;
  /** Optional cheap availability probe (binary on PATH, host reachable...). */
  isAvailable?: () => boolean | Promise<boolean>;
}
