import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import type { IProvider } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  LLMProvider,
  ProviderPermissionDecision,
  ProviderRunFunction,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
  SessionProcessSnapshot,
  SessionTaskOutputTarget,
} from '@/shared/types.js';

type ProviderRuntimeServiceDependencies = {
  listProviders(): IProvider[];
  resolveProvider(provider: string): IProvider;
  resolveProviderSessionId(sessionId: string | null | undefined): string | null;
  resolveResumeModel(
    provider: LLMProvider,
    sessionId: string | undefined,
    requestedModel?: string | null,
  ): Promise<string | undefined>;
  getProviderModels: typeof providerModelsService.getProviderModels;
};

const defaultDependencies: ProviderRuntimeServiceDependencies = {
  listProviders: () => providerRegistry.listProviders(),
  resolveProvider: (provider) => providerRegistry.resolveProvider(provider),
  resolveProviderSessionId: (sessionId) => sessionsService.resolveProviderSessionId(sessionId),
  resolveResumeModel: (provider, sessionId, requestedModel) =>
    providerModelsService.resolveResumeModel(provider, sessionId, requestedModel),
  getProviderModels: (provider) => providerModelsService.getProviderModels(provider),
};

/**
 * Creates the application-facing provider runtime dispatcher.
 *
 * The provider registry owns each concrete runtime. This service supplies the
 * registry-backed model/session lookups at execution time so runtime adapters
 * never import services that resolve back through the registry.
 */
export function createProviderRuntimeService(
  dependencyOverrides: Partial<ProviderRuntimeServiceDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };

  const createRuntimeContext = (
    provider: IProvider,
  ): ProviderRuntimeContext => ({
    resolveProviderSessionId: dependencies.resolveProviderSessionId,
    resolveResumeModel: (sessionId, requestedModel) =>
      dependencies.resolveResumeModel(provider.id, sessionId, requestedModel),
    getProviderModels: async () => dependencies.getProviderModels(provider.id),
    normalizeMessage: (raw, sessionId) => provider.sessions.normalizeMessage(raw, sessionId),
    async isProviderInstalled() {
      try {
        return (await provider.auth.getStatus()).installed;
      } catch {
        // Preserve the runtime's original error when installation probing fails.
        return true;
      }
    },
  });

  const run = (
    providerName: LLMProvider,
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
  ): Promise<unknown> => {
    const provider = dependencies.resolveProvider(providerName);
    return provider.runtime.run(command, options, writer, createRuntimeContext(provider));
  };

  return {
    run,

    hasRuntime(providerName: string): boolean {
      try {
        return Boolean(dependencies.resolveProvider(providerName).runtime);
      } catch {
        return false;
      }
    },

    getRunner(provider: LLMProvider): ProviderRunFunction {
      return (command, options, writer) => run(provider, command, options, writer);
    },

    async abort(providerName: LLMProvider, sessionId: string): Promise<boolean> {
      return Boolean(await dependencies.resolveProvider(providerName).runtime.abort(sessionId));
    },

    /**
     * Ends the session's process. False when the provider keeps none or none
     * was alive for this session.
     */
    async close(providerName: LLMProvider, sessionId: string): Promise<boolean> {
      const runtime = dependencies.resolveProvider(providerName).runtime;
      return runtime.close ? Boolean(await runtime.close(sessionId)) : false;
    },

    /**
     * Stops one task of the session's process. False when the provider does
     * not report tasks, the session has no process, or the task is not one of
     * its.
     */
    async stopTask(providerName: LLMProvider, sessionId: string, taskId: string): Promise<boolean> {
      const runtime = dependencies.resolveProvider(providerName).runtime;
      return runtime.stopTask ? Boolean(await runtime.stopTask(sessionId, taskId)) : false;
    },

    /**
     * What the session's process knows about one of its tasks: where its
     * output is being written, and whether it is still running. Null when no
     * provider has a live process for the session, or none of them reported
     * that task. The path never leaves this lookup as something a caller can
     * choose — it is read off the task's own record.
     */
    describeSessionTask(sessionId: string, taskId: string): SessionTaskOutputTarget | null {
      for (const provider of dependencies.listProviders()) {
        const target = provider.runtime.describeTask?.(sessionId, taskId);
        if (target) {
          return target;
        }
      }
      return null;
    },

    getSessionProcess(sessionId: string): SessionProcessSnapshot | null {
      for (const provider of dependencies.listProviders()) {
        const snapshot = provider.runtime.processes?.get(sessionId);
        if (snapshot) {
          return snapshot;
        }
      }
      return null;
    },

    listSessionProcesses(): SessionProcessSnapshot[] {
      return dependencies.listProviders().flatMap(
        (provider) => provider.runtime.processes?.list() ?? [],
      );
    },

    /** Subscribes to every provider's process changes; returns the unsubscribe. */
    onSessionProcessChange(listener: (snapshot: SessionProcessSnapshot) => void): () => void {
      const unsubscribes = dependencies.listProviders().map(
        (provider) => provider.runtime.processes?.onChange(listener) ?? (() => {}),
      );
      return () => {
        for (const unsubscribe of unsubscribes) {
          unsubscribe();
        }
      };
    },

    /** Ends every process every provider keeps, for the server's shutdown. */
    async closeAllSessionProcesses(): Promise<void> {
      await Promise.all(
        dependencies.listProviders().map((provider) => provider.runtime.processes?.closeAll()),
      );
    },

    resolveToolApproval(requestId: string, decision: ProviderPermissionDecision): void {
      for (const provider of dependencies.listProviders()) {
        provider.runtime.permissions?.resolve(requestId, decision);
      }
    },

    getPendingApprovalsForSession(sessionId: string): unknown[] {
      return dependencies.listProviders().flatMap(
        (provider) => provider.runtime.permissions?.listPending(sessionId) ?? [],
      );
    },
  };
}

export const providerRuntimeService = createProviderRuntimeService();
