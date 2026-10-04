import type { AdapterDescriptor, CapabilityId, OperationSpec } from "./types.js";

/**
 * One adapter's side of a capability. An adapter can expose several
 * operations for the same capability (e.g. start/stop for "instrument.server"),
 * so a provider carries all of them rather than picking one.
 */
export interface CapabilityProvider {
  adapter: AdapterDescriptor;
  operations: OperationSpec[];
}

const CAPABILITY_ID = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/;

/**
 * Tracks which adapters provide which capabilities. This is what lets one
 * backend disappear while the capability keeps working through another.
 */
export class CapabilityRegistry {
  private adapters = new Map<string, AdapterDescriptor>();

  /** Validates before storing, so a bad descriptor never half-registers. Re-registering a kind replaces it. */
  register(descriptor: AdapterDescriptor): void {
    const seen = new Set<string>();
    for (const op of descriptor.operations) {
      if (!CAPABILITY_ID.test(op.capability)) {
        throw new Error(
          `Adapter "${descriptor.kind}" operation "${op.name}" has invalid capability id "${op.capability}"`,
        );
      }
      if (seen.has(op.name)) {
        throw new Error(`Adapter "${descriptor.kind}" declares operation "${op.name}" twice`);
      }
      seen.add(op.name);
    }
    this.adapters.set(descriptor.kind, descriptor);
  }

  unregister(kind: string): void {
    this.adapters.delete(kind);
  }

  getAdapter(kind: string): AdapterDescriptor | undefined {
    return this.adapters.get(kind);
  }

  listAdapters(): AdapterDescriptor[] {
    return [...this.adapters.values()];
  }

  listCapabilities(): CapabilityId[] {
    const ids = new Set<CapabilityId>();
    for (const adapter of this.adapters.values()) {
      for (const op of adapter.operations) ids.add(op.capability);
    }
    return [...ids].sort();
  }

  /** Every adapter offering a capability, highest priority first (ties keep registration order). */
  providersOf(capability: CapabilityId): CapabilityProvider[] {
    const out: CapabilityProvider[] = [];
    for (const adapter of this.adapters.values()) {
      const operations = adapter.operations.filter((op) => op.capability === capability);
      if (operations.length > 0) out.push({ adapter, operations });
    }
    return out.sort((a, b) => (b.adapter.priority ?? 0) - (a.adapter.priority ?? 0));
  }

  /** Best available provider, skipping adapters whose isAvailable() says no. */
  async resolve(capability: CapabilityId): Promise<CapabilityProvider | undefined> {
    for (const provider of this.providersOf(capability)) {
      try {
        if (!provider.adapter.isAvailable || (await provider.adapter.isAvailable())) {
          return provider;
        }
      } catch {
        // A failing probe counts as unavailable - try the next backend.
      }
    }
    return undefined;
  }
}

export const capabilityRegistry = new CapabilityRegistry();
