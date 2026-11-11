begin;

alter table public.feedback
  add column image_base64 text,
  add column image_prompt text,
  add constraint feedback_attachment_valid check (
    (image_base64 is null and image_prompt is null)
    or (
      image_base64 is not null
      and image_prompt is not null
      and octet_length(image_base64) between 4 and 1398104
      and char_length(image_prompt) <= 1000
    )
  );

commit;
