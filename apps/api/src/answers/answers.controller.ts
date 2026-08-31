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
    return buildSuccess(
      await this.answersService.answer(auth, parseRequest(AskQuestionRequestSchema, body)),
    );
  }

  @Post('stream')
  @Header('Content-Type', 'text/event-stream; charset=utf-8')
  async stream(
    @Body() body: unknown,
    @CurrentAuth() auth: AuthContext,
    @Res() response: StreamingResponse,
  ): Promise<void> {
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
        parseRequest(AskQuestionRequestSchema, body),
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
