import fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import path from 'node:path';

import spawn from 'cross-spawn';

import { projectsDb } from '@/modules/database/index.js';
import { getClaudeConfigDirectory, getClaudeGlobalConfigPath } from '@/shared/utils.js';

import { createTaskmasterRouter } from './taskmaster.routes.js';
import { createTaskmasterService } from './taskmaster.service.js';

const taskmasterService = createTaskmasterService({
  readTextFile: (filePath) => fsPromises.readFile(filePath, 'utf8'),
  getClaudeConfigFilePaths: () => [
    getClaudeGlobalConfigPath(),
    path.join(getClaudeConfigDirectory(), 'settings.json'),
  ],
});

/** Used by the server entrypoint to mount authenticated TaskMaster endpoints. */
export const taskmasterRoutes = createTaskmasterRouter({
  fileSystem: fs,
  fileSystemPromises: fsPromises,
  spawnProcess: spawn,
  resolveProjectPathById: (projectId) => projectsDb.getProjectPathById(projectId),
  taskmasterService,
});
