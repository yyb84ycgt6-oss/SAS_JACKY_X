
-- Drop existing storage policies that allow anonymous access
DROP POLICY IF EXISTS "Users can view own chat attachments" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete own chat attachments" ON storage.objects;
DROP POLICY IF EXISTS "Users can upload chat attachments" ON storage.objects;
DROP POLICY IF EXISTS "Users can insert chat attachments" ON storage.objects;

-- Recreate all policies scoped to authenticated role only
CREATE POLICY "Authenticated users can view own chat attachments"
ON storage.objects FOR SELECT
TO authenticated
USING (bucket_id = 'chat-attachments' AND (storage.foldername(name))[1] = (auth.uid())::text);

CREATE POLICY "Authenticated users can upload chat attachments"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'chat-attachments' AND (storage.foldername(name))[1] = (auth.uid())::text);

CREATE POLICY "Authenticated users can update own chat attachments"
ON storage.objects FOR UPDATE
TO authenticated
USING (bucket_id = 'chat-attachments' AND (storage.foldername(name))[1] = (auth.uid())::text);

CREATE POLICY "Authenticated users can delete own chat attachments"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'chat-attachments' AND (storage.foldername(name))[1] = (auth.uid())::text);
