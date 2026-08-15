import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { LIMITS, type MessageDto, type UserDto } from '@codexa/shared';

const messageSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    body: { type: String, required: true, maxlength: LIMITS.MAX_CHAT_MESSAGE_LENGTH },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

messageSchema.index({ projectId: 1, createdAt: -1 });

export type MessageAttrs = InferSchemaType<typeof messageSchema>;
export type MessageDoc = HydratedDocument<MessageAttrs>;

export const Message = model('Message', messageSchema);

export function toMessageDto(message: MessageDoc, author: UserDto): MessageDto {
  return {
    id: String(message._id),
    projectId: String(message.projectId),
    author,
    body: message.body,
    createdAt: message.createdAt.toISOString(),
  };
}
