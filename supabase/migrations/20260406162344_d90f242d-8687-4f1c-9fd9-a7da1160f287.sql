
-- chat_attachments
DROP POLICY IF EXISTS "Users can view own attachments" ON public.chat_attachments;
DROP POLICY IF EXISTS "Users can insert own attachments" ON public.chat_attachments;
DROP POLICY IF EXISTS "Users can delete own attachments" ON public.chat_attachments;

CREATE POLICY "Users can view own attachments" ON public.chat_attachments FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own attachments" ON public.chat_attachments FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own attachments" ON public.chat_attachments FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- chat_messages
DROP POLICY IF EXISTS "Users can view own messages" ON public.chat_messages;
DROP POLICY IF EXISTS "Users can insert own messages" ON public.chat_messages;
DROP POLICY IF EXISTS "Users can delete own messages" ON public.chat_messages;

CREATE POLICY "Users can view own messages" ON public.chat_messages FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own messages" ON public.chat_messages FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own messages" ON public.chat_messages FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- conversation_tag_links
DROP POLICY IF EXISTS "Users can view own tag links" ON public.conversation_tag_links;
DROP POLICY IF EXISTS "Users can insert own tag links" ON public.conversation_tag_links;
DROP POLICY IF EXISTS "Users can delete own tag links" ON public.conversation_tag_links;

CREATE POLICY "Users can view own tag links" ON public.conversation_tag_links FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own tag links" ON public.conversation_tag_links FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own tag links" ON public.conversation_tag_links FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- conversation_tags
DROP POLICY IF EXISTS "Users can view own tags" ON public.conversation_tags;
DROP POLICY IF EXISTS "Users can insert own tags" ON public.conversation_tags;
DROP POLICY IF EXISTS "Users can update own tags" ON public.conversation_tags;
DROP POLICY IF EXISTS "Users can delete own tags" ON public.conversation_tags;

CREATE POLICY "Users can view own tags" ON public.conversation_tags FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own tags" ON public.conversation_tags FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own tags" ON public.conversation_tags FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own tags" ON public.conversation_tags FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- conversations
DROP POLICY IF EXISTS "Users can view own conversations" ON public.conversations;
DROP POLICY IF EXISTS "Users can insert own conversations" ON public.conversations;
DROP POLICY IF EXISTS "Users can update own conversations" ON public.conversations;
DROP POLICY IF EXISTS "Users can delete own conversations" ON public.conversations;

CREATE POLICY "Users can view own conversations" ON public.conversations FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own conversations" ON public.conversations FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own conversations" ON public.conversations FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own conversations" ON public.conversations FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- game_design_entries
DROP POLICY IF EXISTS "Users can view own entries" ON public.game_design_entries;
DROP POLICY IF EXISTS "Users can insert own entries" ON public.game_design_entries;
DROP POLICY IF EXISTS "Users can update own entries" ON public.game_design_entries;
DROP POLICY IF EXISTS "Users can delete own entries" ON public.game_design_entries;

CREATE POLICY "Users can view own entries" ON public.game_design_entries FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own entries" ON public.game_design_entries FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own entries" ON public.game_design_entries FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own entries" ON public.game_design_entries FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- game_projects
DROP POLICY IF EXISTS "Users can view own projects" ON public.game_projects;
DROP POLICY IF EXISTS "Users can insert own projects" ON public.game_projects;
DROP POLICY IF EXISTS "Users can update own projects" ON public.game_projects;
DROP POLICY IF EXISTS "Users can delete own projects" ON public.game_projects;

CREATE POLICY "Users can view own projects" ON public.game_projects FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own projects" ON public.game_projects FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own projects" ON public.game_projects FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can delete own projects" ON public.game_projects FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- storage: fix to authenticated only
DROP POLICY IF EXISTS "Authenticated users can view own chat attachments" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload chat attachments" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can update own chat attachments" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can delete own chat attachments" ON storage.objects;

CREATE POLICY "Auth users can view own chat attachments" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'chat-attachments' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Auth users can upload chat attachments" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'chat-attachments' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Auth users can update own chat attachments" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'chat-attachments' AND auth.uid()::text = (storage.foldername(name))[1]);
CREATE POLICY "Auth users can delete own chat attachments" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'chat-attachments' AND auth.uid()::text = (storage.foldername(name))[1]);
