# Goal:

## This is a twitch integration with the Neural Nexus API to allow for the avatars to be queryable through twitch chat. Each avatar is a twitch-bot. Twitch chat is streamed to the avatar. The avatar may choose to respond, ignore, or notify the owner of the avatar (this assumes using their personal avatar; other avatars may be added from the neural nexus). Chat is able to @mention the avatar. For direct mentions to the messaging endpoint for gauranteed responses from the avatar. The personal avatar is able to learn to moderate chat and is able to be granted permissions (future_feature); The scope of this currently is to allow for the Neural Nexus API avatars to be used at all :

### Feature development order:
- (direct message when @avatar) (now)
- then feed the stream of conversation for respond, notify, ignore: (future)
- then learned moderation capabilities (future)

https://dev.twitch.tv/docs/chat/

A user should be able to use all the commands of the neural nexus from within twitch and communicate with distinct avatars as distinct twitch bots. 
There should be the ability to have different twitch bots that are each distinct avatars from the same user account.

Only the personal avatar may be used as a twitch bot (user-is-creator)

<!-- https://dev.twitch.tv/docs/chat/chatbot-guide/ -->


<!-- https://www.twitch.tv/afterlife_test/about -->




