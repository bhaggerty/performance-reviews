import { getEmployeeBySlackId } from '../db/employees';
import type { Employee } from '../types';

export type AppContext = { employee?: Employee | null };

export async function getEmployeeForSlackUser(slackUserId: string): Promise<Employee | null> {
  return getEmployeeBySlackId(slackUserId);
}
