/**
 * Tool registry — now backed by Postgres via kapow-db.
 * Replaces the old JSON file-based registry.
 */
import {
  getAllTools, getReadyTools as dbGetReadyTools, getToolById as dbGetToolById,
  queryTools as dbQueryTools, upsertTool as dbUpsertTool,
  updateToolStatus as dbUpdateToolStatus, deleteTool as dbDeleteTool,
  type ToolRecord, type ToolStatus,
} from 'kapow-db/tools';

export type { ToolRecord as ToolDefinition, ToolStatus };

export async function loadTools(): Promise<ToolRecord[]> {
  return getAllTools();
}

export async function getReadyTools(): Promise<ToolRecord[]> {
  return dbGetReadyTools();
}

export async function getToolById(id: string): Promise<ToolRecord | null> {
  return dbGetToolById(id);
}

export async function queryTools(query: {
  status?: ToolStatus;
  tags?: string[];
  search?: string;
}): Promise<ToolRecord[]> {
  return dbQueryTools(query);
}

export async function upsertTool(tool: Omit<ToolRecord, 'createdAt' | 'updatedAt'>): Promise<ToolRecord> {
  return dbUpsertTool(tool);
}

export async function updateToolStatus(id: string, status: ToolStatus): Promise<ToolRecord | null> {
  return dbUpdateToolStatus(id, status);
}

export async function deleteToolById(id: string): Promise<boolean> {
  return dbDeleteTool(id);
}
