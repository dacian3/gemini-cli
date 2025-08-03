/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// start of code-trinity
import * as fs from 'fs';
//end of code-trinity

import path from 'path';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { makeRelative, shortenPath } from '../utils/paths.js';
import { BaseTool, Icon, ToolLocation, ToolResult } from './tools.js';
import { Type } from '@google/genai';
import {
  processSingleFileContent,
  getSpecificMimeType,
} from '../utils/fileUtils.js';
import { Config } from '../config/config.js';

// start of code-trinity
import { parseSize } from '../config/config.js';
// end of code-trinity

import {
  recordFileOperationMetric,
  FileOperation,
} from '../telemetry/metrics.js';

/**
 * Parameters for the ReadFile tool
 */
export interface ReadFileToolParams {
  /**
   * The absolute path to the file to read
   */
  absolute_path: string;

  /**
   * The line number to start reading from (optional)
   */
  offset?: number;

  /**
   * The number of lines to read (optional)
   */
  limit?: number;
}

/**
 * Implementation of the ReadFile tool logic
 */
export class ReadFileTool extends BaseTool<ReadFileToolParams, ToolResult> {
  static readonly Name: string = 'read_file';

  constructor(private config: Config) {
    super(
      ReadFileTool.Name,
      'ReadFile',
      'Reads and returns the content of a specified file from the local filesystem. Handles text, images (PNG, JPG, GIF, WEBP, SVG, BMP), and PDF files. For text files, it can read specific line ranges.',
      Icon.FileSearch,
      {
        properties: {
          absolute_path: {
            description:
              "The absolute path to the file to read (e.g., '/home/user/project/file.txt'). Relative paths are not supported. You must provide an absolute path.",
            type: Type.STRING,
          },
          offset: {
            description:
              "Optional: For text files, the 0-based line number to start reading from. Requires 'limit' to be set. Use for paginating through large files.",
            type: Type.NUMBER,
          },
          limit: {
            description:
              "Optional: For text files, maximum number of lines to read. Use with 'offset' to paginate through large files. If omitted, reads the entire file (if feasible, up to a default limit).",
            type: Type.NUMBER,
          },
        },
        required: ['absolute_path'],
        type: Type.OBJECT,
      },
    );
  }

  validateToolParams(params: ReadFileToolParams): string | null {
    const errors = SchemaValidator.validate(this.schema.parameters, params);
    if (errors) {
      return errors;
    }

    const filePath = params.absolute_path;
    if (!path.isAbsolute(filePath)) {
      return `File path must be absolute, but was relative: ${filePath}. You must provide an absolute path.`;
    }

    const workspaceContext = this.config.getWorkspaceContext();
    if (!workspaceContext.isPathWithinWorkspace(filePath)) {
      const directories = workspaceContext.getDirectories();
      return `File path must be within one of the workspace directories: ${directories.join(', ')}`;
    }
    if (params.offset !== undefined && params.offset < 0) {
      return 'Offset must be a non-negative number';
    }
    if (params.limit !== undefined && params.limit <= 0) {
      return 'Limit must be a positive number';
    }

    const fileService = this.config.getFileService();
    if (fileService.shouldGeminiIgnoreFile(params.absolute_path)) {
      return `File path '${filePath}' is ignored by .geminiignore pattern(s).`;
    }

    return null;
  }

  getDescription(params: ReadFileToolParams): string {
    if (
      !params ||
      typeof params.absolute_path !== 'string' ||
      params.absolute_path.trim() === ''
    ) {
      return `Path unavailable`;
    }
    const relativePath = makeRelative(
      params.absolute_path,
      this.config.getTargetDir(),
    );
    return shortenPath(relativePath);
  }

  // start of code-trinity
  /**
   *  Formats a byte count into a human readable string (KB, MB, GB).
   */
  private formatBytes(bytes: number, decimals = 1): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }
  // end of code-trinity

  toolLocations(params: ReadFileToolParams): ToolLocation[] {
    return [{ path: params.absolute_path, line: params.offset }];
  }

  async execute(
    params: ReadFileToolParams,
    _signal: AbortSignal,
  ): Promise<ToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: `Error: Invalid parameters provided. Reason: ${validationError}`,
        returnDisplay: validationError,
      };
    }

    // start of code-trinity
    // do not check size if user is asking for a specific slice.
    if (!params.offset && typeof params.limit === 'undefined') {
      try {
        const maxFileSize = parseSize(this.config.max_file_size);
        const stats = fs.statSync(params.absolute_path);
        if (stats.size > maxFileSize) {
          const fileSizeStr = this.formatBytes(stats.size);
          const maxFileSizeStr = this.config.max_file_size;
          const errorMsg = `Error: File '${path.basename(params.absolute_path)}' (${fileSizeStr}) exceeds the configured max_file_size of ${maxFileSizeStr}.`;
          return {
            llmContent: errorMsg,
            returnDisplay: errorMsg,
          };
        }
      } catch (e) {
        const errorMsg = `Error checking file size: ${e.message}`;
        return {
          llmContent: errorMsg,
          returnDisplay: errorMsg,
        };
      }
    }
    // end of code-trinity

    const result = await processSingleFileContent(
      params.absolute_path,
      this.config.getTargetDir(),
      params.offset,
      params.limit,
    );

    if (result.error) {
      return {
        llmContent: result.error, // The detailed error for LLM
        returnDisplay: result.returnDisplay || 'Error reading file', // User-friendly error
      };
    }

    const lines =
      typeof result.llmContent === 'string'
        ? result.llmContent.split('\n').length
        : undefined;
    const mimetype = getSpecificMimeType(params.absolute_path);
    recordFileOperationMetric(
      this.config,
      FileOperation.READ,
      lines,
      mimetype,
      path.extname(params.absolute_path),
    );

    return {
      llmContent: result.llmContent || '',
      returnDisplay: result.returnDisplay || '',
    };
  }
}
