export interface Project {
  id: string;
  name: string;
  description?: string;
  skills: string[];
  systemPrompt?: string;
  createdAt: number;
  updatedAt: number;
}
