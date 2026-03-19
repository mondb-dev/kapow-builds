import { prisma } from './client.js';

export interface ProjectData {
  id: string;
  name: string;
  description: string | null;
  repoUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function createProject(name: string, description?: string, repoUrl?: string): Promise<ProjectData> {
  return prisma.project.create({
    data: { name, description, repoUrl },
  });
}

export async function getProject(id: string): Promise<ProjectData | null> {
  return prisma.project.findUnique({ where: { id } });
}

export async function listProjects(): Promise<ProjectData[]> {
  return prisma.project.findMany({ orderBy: { updatedAt: 'desc' } });
}

export async function updateProject(id: string, data: Partial<Pick<ProjectData, 'name' | 'description' | 'repoUrl'>>): Promise<ProjectData> {
  return prisma.project.update({ where: { id }, data });
}
