-- Native auth statements enter the same order as mixed application transactions.
-- Unconditional, including zero-row writes; no semantic revocation for profile/security edits.
CREATE FUNCTION public.voice_auth_statement_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(810025);
  PERFORM pg_advisory_xact_lock(810030);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER voice_auth_statement_guard BEFORE INSERT OR UPDATE OR DELETE
ON public."user" FOR EACH STATEMENT EXECUTE FUNCTION public.voice_auth_statement_guard();
--> statement-breakpoint
CREATE TRIGGER voice_auth_statement_guard BEFORE INSERT OR UPDATE OR DELETE
ON public."session" FOR EACH STATEMENT EXECUTE FUNCTION public.voice_auth_statement_guard();
--> statement-breakpoint
CREATE TRIGGER voice_auth_statement_guard BEFORE INSERT OR UPDATE OR DELETE
ON public."account" FOR EACH STATEMENT EXECUTE FUNCTION public.voice_auth_statement_guard();
--> statement-breakpoint
CREATE TRIGGER voice_auth_statement_guard BEFORE INSERT OR UPDATE OR DELETE
ON public."verification" FOR EACH STATEMENT EXECUTE FUNCTION public.voice_auth_statement_guard();
--> statement-breakpoint
CREATE TRIGGER voice_auth_statement_guard BEFORE INSERT OR UPDATE OR DELETE
ON public."two_factor" FOR EACH STATEMENT EXECUTE FUNCTION public.voice_auth_statement_guard();
--> statement-breakpoint
CREATE TRIGGER voice_auth_statement_guard BEFORE INSERT OR UPDATE OR DELETE
ON public."passkey" FOR EACH STATEMENT EXECUTE FUNCTION public.voice_auth_statement_guard();
--> statement-breakpoint
CREATE TRIGGER voice_auth_statement_guard BEFORE INSERT OR UPDATE OR DELETE
ON public."dm_device" FOR EACH STATEMENT EXECUTE FUNCTION public.voice_auth_statement_guard();
--> statement-breakpoint
-- FK cascades execute in the native deletion transaction. Never acquire another advisory here.
CREATE FUNCTION public.voice_member_delete_generation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.state <> 'left' THEN
    UPDATE public.voice_call SET generation = generation + 1
      WHERE id = OLD.call_id AND status = 'active';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER voice_member_delete_generation AFTER DELETE ON public.voice_call_member
FOR EACH ROW EXECUTE FUNCTION public.voice_member_delete_generation();
