-- Avatar uploads via Supabase Storage.
--
-- Uploads go straight from the browser to Storage, not through Vercel — image
-- bytes through a serverless function is slow and pointless. RLS on
-- storage.objects is what keeps players inside their own folder.
--
-- A note worth reading before you turn uploads on: user-uploaded images in a
-- card game attract exactly the content you'd expect. Nothing here moderates
-- anything. The presets are the safe default; treat uploads as a feature you
-- can switch off if it goes wrong.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152,
        ARRAY['image/jpeg','image/png','image/webp'])
on conflict (id) do update
  set public = true,
      file_size_limit = 2097152,
      allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp'];

-- Anyone can read: avatars show to opponents.
drop policy if exists "avatars are public" on storage.objects;
create policy "avatars are public"
  on storage.objects for select
  using (bucket_id = 'avatars');

-- You can only write inside a folder named after your own user id.
drop policy if exists "own avatar upload" on storage.objects;
create policy "own avatar upload"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars'
              and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own avatar update" on storage.objects;
create policy "own avatar update"
  on storage.objects for update to authenticated
  using (bucket_id = 'avatars'
         and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own avatar delete" on storage.objects;
create policy "own avatar delete"
  on storage.objects for delete to authenticated
  using (bucket_id = 'avatars'
         and (storage.foldername(name))[1] = auth.uid()::text);

select id, public, file_size_limit from storage.buckets where id = 'avatars';
