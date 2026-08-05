/**
 * Server-side filtering strategy
 * 
 * This strategy attempts to use Vikunja's server-side filtering capabilities
 * by passing filter parameters directly to the API. This is the most efficient
 * approach when the server supports advanced filtering.
 */

import type { TaskFilteringStrategy } from './TaskFilteringStrategy';
import type { FilteringParams, FilteringResult } from './types';
import { getClientFromContext } from '../../client';
import { validateId } from '../../tools/tasks/validation';
import { logger } from '../logger';
import { MCPError, ErrorCode } from '../../types';
import { fetchAllPages } from './pagination';

export class ServerSideFilteringStrategy implements TaskFilteringStrategy {
  async execute(params: FilteringParams): Promise<FilteringResult> {
    const { args, filterString, params: apiParams } = params;
    
    if (!filterString) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        'Server-side filtering requires a filter string'
      );
    }

    const client = await getClientFromContext();
    const serverParams = { ...apiParams, filter: filterString };
    
    logger.info('Attempting server-side filtering', {
      filter: filterString,
      endpoint: args.projectId && !args.allProjects ? 'getProjectTasks' : 'getAllTasks'
    });
    
    let tasks;
    try {
      // Exhaust pages rather than trusting per_page: Vikunja clamps it to
      // max_items_per_page (50 by default), so a single request silently drops
      // every match beyond the first page while still reporting the short count.
      const autoPaginate = params.autoPaginate ?? false;
      // Return type is inferred from the client so it stays in step with
      // node-vikunja's Task, which differs from this repo's own Task interface.
      const fetchPage = (
        p: typeof serverParams,
      ): ReturnType<typeof client.tasks.getAllTasks> => {
        if (args.projectId !== undefined && !args.allProjects) {
          // Validate project ID
          validateId(args.projectId, 'projectId');
          // Get tasks for specific project with server-side filter
          return client.tasks.getProjectTasks(args.projectId, p);
        }
        // Get all tasks across all projects with server-side filter
        return client.tasks.getAllTasks(p);
      };

      const page = await fetchAllPages(fetchPage, serverParams, autoPaginate);
      tasks = page.items;

      logger.info('Server-side filtering completed successfully', {
        taskCount: tasks?.length || 0,
        pagesFetched: page.pagesFetched,
        truncated: page.truncated,
        filter: filterString
      });
      
      return {
        tasks: tasks || [],
        metadata: {
          serverSideFilteringUsed: true,
          serverSideFilteringAttempted: true,
          clientSideFiltering: false,
          filteringNote: 'Server-side filtering used (modern Vikunja)'
        }
      };
      
    } catch (error) {
      logger.error('Server-side filtering failed', {
        error: error instanceof Error ? error.message : String(error),
        filter: filterString
      });
      
      // Re-throw the error to be handled by the calling code
      throw error;
    }
  }
}