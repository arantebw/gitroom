import { Injectable } from '@nestjs/common';
import { PostsRepository } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.repository';
import { CreatePostDto } from '@gitroom/nestjs-libraries/dtos/posts/create.post.dto';
import { BullMqClient } from '@gitroom/nestjs-libraries/bull-mq-transport/client/bull-mq.client';
import dayjs from 'dayjs';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { Integration, Post, Media } from '@prisma/client';
import { GetPostsDto } from '@gitroom/nestjs-libraries/dtos/posts/get.posts.dto';

type PostWithConditionals = Post & {
  integration?: Integration;
  childrenPost: Post[];
};

@Injectable()
export class PostsService {
  constructor(
    private _postRepository: PostsRepository,
    private _workerServiceProducer: BullMqClient,
    private _integrationManager: IntegrationManager
  ) {}

  async getPostsRecursively(
    id: string,
    includeIntegration = false,
    orgId?: string
  ): Promise<PostWithConditionals[]> {
    const post = await this._postRepository.getPost(
      id,
      includeIntegration,
      orgId
    );
    return [
      post!,
      ...(post?.childrenPost?.length
        ? await this.getPostsRecursively(post.childrenPost[0].id, false, orgId)
        : []),
    ];
  }

  getPosts(orgId: string, query: GetPostsDto) {
    return this._postRepository.getPosts(orgId, query);
  }

  async getPost(orgId: string, id: string) {
    const posts = await this.getPostsRecursively(id, false, orgId);
    return {
      group: posts?.[0]?.group,
      posts: posts.map((post) => ({
        ...post,
        image: JSON.parse(post.image || '[]'),
      })),
      integration: posts[0].integrationId,
      settings: JSON.parse(posts[0].settings || '{}'),
    };
  }

  async getOldPosts(orgId: string, date: string) {
    return this._postRepository.getOldPosts(orgId, date);
  }

  async post(id: string) {
    const [firstPost, ...morePosts] = await this.getPostsRecursively(id, true);
    if (!firstPost) {
      return;
    }

    if (firstPost.integration?.type === 'article') {
      return this.postArticle(firstPost.integration!, [
        firstPost,
        ...morePosts,
      ]);
    }

    return this.postSocial(firstPost.integration!, [firstPost, ...morePosts]);
  }

  private async updateTags(orgId: string, post: Post[]): Promise<Post[]> {
    const plainText = JSON.stringify(post);
    const extract = Array.from(
      plainText.match(/\(post:[a-zA-Z0-9-_]+\)/g) || []
    );
    if (!extract.length) {
      return post;
    }

    const ids = extract.map((e) => e.replace('(post:', '').replace(')', ''));
    const urls = await this._postRepository.getPostUrls(orgId, ids);
    const newPlainText = ids.reduce((acc, value) => {
      const findUrl = urls?.find?.((u) => u.id === value)?.releaseURL || '';
      return acc.replace(new RegExp(`\\(post:${value}\\)`, 'g'), findUrl.split(',')[0]);
    }, plainText);

    return this.updateTags(orgId, JSON.parse(newPlainText) as Post[]);
  }

  private async postSocial(integration: Integration, posts: Post[]) {
    const getIntegration = this._integrationManager.getSocialIntegration(
      integration.providerIdentifier
    );
    if (!getIntegration) {
      return;
    }

    const newPosts = await this.updateTags(integration.organizationId, posts);

    const publishedPosts = await getIntegration.post(
      integration.internalId,
      integration.token,
      newPosts.map((p) => ({
        id: p.id,
        message: p.content,
        settings: JSON.parse(p.settings || '{}'),
        media: (JSON.parse(p.image || '[]') as Media[]).map((m) => ({
          url:
            process.env.FRONTEND_URL +
            '/' +
            process.env.NEXT_PUBLIC_UPLOAD_STATIC_DIRECTORY +
            m.path,
          type: 'image',
          path: process.env.UPLOAD_DIRECTORY + m.path,
        })),
      }))
    );

    for (const post of publishedPosts) {
      await this._postRepository.updatePost(
        post.id,
        post.postId,
        post.releaseURL
      );
    }
  }

  private async postArticle(integration: Integration, posts: Post[]) {
    const getIntegration = this._integrationManager.getArticlesIntegration(
      integration.providerIdentifier
    );
    if (!getIntegration) {
      return;
    }

    const newPosts = await this.updateTags(integration.organizationId, posts);

    const { postId, releaseURL } = await getIntegration.post(
      integration.token,
      newPosts.map((p) => p.content).join('\n\n'),
      JSON.parse(newPosts[0].settings || '{}')
    );
    await this._postRepository.updatePost(newPosts[0].id, postId, releaseURL);
  }

  async deletePost(orgId: string, group: string) {
    const post = await this._postRepository.deletePost(orgId, group);
    if (post?.id) {
      await this._workerServiceProducer.delete('post', post.id);
    }
  }

  async createPost(orgId: string, body: CreatePostDto) {
    for (const post of body.posts) {
      const { previousPost, posts } =
        await this._postRepository.createOrUpdatePost(
          body.type,
          orgId,
          body.date,
          post
        );

      if (posts?.length) {
        await this._workerServiceProducer.delete(
          'post',
          previousPost ? previousPost : posts?.[0]?.id
        );
        if (body.type === 'schedule' && dayjs(body.date).isAfter(dayjs())) {
          this._workerServiceProducer.emit('post', {
            id: posts[0].id,
            options: {
              delay: 0, //dayjs(posts[0].publishDate).diff(dayjs(), 'millisecond'),
            },
            payload: {
              id: posts[0].id,
            },
          });
        }
      }
    }
  }

  async changeDate(orgId: string, id: string, date: string) {
    await this._workerServiceProducer.delete('post', id);
    this._workerServiceProducer.emit('post', {
      id: id,
      options: {
        delay: dayjs(date).diff(dayjs(), 'millisecond'),
      },
      payload: {
        id: id,
      },
    });
    return this._postRepository.changeDate(orgId, id, date);
  }
}