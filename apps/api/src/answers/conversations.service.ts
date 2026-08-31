import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  AnswerCitation,
  ConversationDetailResponse,
  ConversationListResponse,
  ConversationQuery,
  DeleteConversationResponse,
} from '@knowledge-base/contracts';
import {
  ChatCitationEntity,
  ChatConversationEntity,
  ChatMessageEntity,
} from '@knowledge-base/database';
import { DataSource, In } from 'typeorm';
import type { AuthContext } from '../auth/auth-context';

@Injectable()
export class ConversationsService {
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  async list(auth: AuthContext, query: ConversationQuery): Promise<ConversationListResponse> {
    const repository = this.dataSource.getRepository(ChatConversationEntity);
    const [items, total] = await repository.findAndCount({
      where: { tenantId: auth.tenantId, createdBy: auth.userId },
      order: { updatedAt: 'DESC', id: 'DESC' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    });
    return {
      items: items.map(toSummary),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async findOne(auth: AuthContext, conversationId: string): Promise<ConversationDetailResponse> {
    const conversation = await this.ownedConversation(auth, conversationId);
    const messages = await this.dataSource.getRepository(ChatMessageEntity).find({
      where: { tenantId: auth.tenantId, conversationId },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    const messageIds = messages.map((message) => message.id);
    const citations =
      messageIds.length === 0
        ? []
        : await this.dataSource.getRepository(ChatCitationEntity).find({
            where: { tenantId: auth.tenantId, messageId: In(messageIds) },
            order: { messageId: 'ASC', ordinal: 'ASC' },
          });
    const citationsByMessage = new Map<string, AnswerCitation[]>();
    for (const citation of citations) {
      const current = citationsByMessage.get(citation.messageId) ?? [];
      current.push({
        ordinal: citation.ordinal,
        chunkId: citation.chunkId,
        documentId: citation.documentId,
        documentVersionId: citation.documentVersionId,
        title: citation.documentTitle,
        excerpt: citation.excerpt,
        source: citation.source as AnswerCitation['source'],
      });
      citationsByMessage.set(citation.messageId, current);
    }
    return {
      ...toSummary(conversation),
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        model: message.model,
        createdAt: message.createdAt.toISOString(),
        citations: citationsByMessage.get(message.id) ?? [],
      })),
    };
  }

  async delete(auth: AuthContext, conversationId: string): Promise<DeleteConversationResponse> {
    await this.ownedConversation(auth, conversationId);
    await this.dataSource.getRepository(ChatConversationEntity).delete({
      id: conversationId,
      tenantId: auth.tenantId,
      createdBy: auth.userId,
    });
    return { conversationId, deleted: true };
  }

  private async ownedConversation(
    auth: AuthContext,
    conversationId: string,
  ): Promise<ChatConversationEntity> {
    const conversation = await this.dataSource.getRepository(ChatConversationEntity).findOne({
      where: { id: conversationId, tenantId: auth.tenantId, createdBy: auth.userId },
    });
    if (!conversation) throw new NotFoundException(`Conversation ${conversationId} not found`);
    return conversation;
  }
}

function toSummary(conversation: ChatConversationEntity) {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
  };
}
