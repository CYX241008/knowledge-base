import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Inject,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  AskQuestionRequestSchema,
  ConversationQuerySchema,
  buildSuccess,
  type ApiResponse,
  type AskQuestionResponse,
  type ConversationDetailResponse,
  type ConversationListResponse,
  type DeleteConversationResponse,
} from '@knowledge-base/contracts';
import type { AuthContext } from '../auth/auth-context';
import { AccessControlService } from '../access-control/access-control.service';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { CurrentAuth } from '../auth/current-auth.decorator';
import { parseRequest } from '../common/validation';
import { AnswersService } from './answers.service';
import { ConversationsService } from './conversations.service';

type StreamingResponse = {
  setHeader(name: string, value: string): void;
  flushHeaders(): void;
  write(chunk: string): boolean;
  end(): void;
  on(event: 'close', listener: () => void): void;
  off(event: 'close', listener: () => void): void;
  writableEnded: boolean;
  destroyed: boolean;
};

@Controller('answers')
@UseGuards(AuthenticationGuard)
export class AnswersController {
  constructor(
    @Inject(AnswersService) private readonly answersService: AnswersService,
    @Inject(ConversationsService) private readonly conversationsService: ConversationsService,
    @Inject(AccessControlService) private readonly accessControl: AccessControlService,
  ) {}

  @Get('conversations')
  async listConversations(
    @Query() query: unknown,
    @CurrentAuth() auth: AuthContext,
  ): Promise<ApiResponse<ConversationListResponse>> {
    return buildSuccess(
      await this.conversationsService.list(auth, parseRequest(ConversationQuerySchema, query)),
    );
  }

  @Get('conversations/:conversationId')
  async getConversation(
    @Param('conversationId') conversationId: string,
    @CurrentAuth() auth: AuthContext,
  ): Promise<ApiResponse<ConversationDetailResponse>> {
    return buildSuccess(await this.conversationsService.findOne(auth, conversationId));
  }

  @Delete('conversations/:conversationId')
  async deleteConversation(
    @Param('conversationId') conversationId: string,
    @CurrentAuth() auth: AuthContext,
  ): Promise<ApiResponse<DeleteConversationResponse>> {
    return buildSuccess(await this.conversationsService.delete(auth, conversationId));
  }

  @Post()
  async answer(
    @Body() body: unknown,
    @CurrentAuth() auth: AuthContext,
  ): Promise<ApiResponse<AskQuestionResponse>> {
    const input = parseRequest(AskQuestionRequestSchema, body);
    if (input.includeDiagnostics) this.accessControl.assertGovernanceRead(auth);
    return buildSuccess(await this.answersService.answer(auth, input));
  }

  @Post('stream')
  @Header('Content-Type', 'text/event-stream; charset=utf-8')
  async stream(
    @Body() body: unknown,
    @CurrentAuth() auth: AuthContext,
    @Res() response: StreamingResponse,
  ): Promise<void> {
    const input = parseRequest(AskQuestionRequestSchema, body);
    if (input.includeDiagnostics) this.accessControl.assertGovernanceRead(auth);
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    const abortController = new AbortController();
    const handleClose = () => abortController.abort();
    response.on('close', handleClose);
    try {
      for await (const event of this.answersService.streamAnswer(
        auth,
        input,
        abortController.signal,
      )) {
        if (abortController.signal.aborted || response.destroyed) break;
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    } catch (error) {
      if (!abortController.signal.aborted && !response.destroyed) {
        response.write(
          `event: error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : 'Answer failed' })}\n\n`,
        );
      }
    } finally {
      response.off('close', handleClose);
      if (!response.writableEnded && !response.destroyed) response.end();
    }
  }
}
