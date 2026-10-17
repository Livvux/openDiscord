CREATE TABLE "voice_sfu_room" (
	"room_name" text PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"call_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	"last_app_token_expiry" timestamp with time zone NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_outcome" text DEFAULT 'pending' NOT NULL,
	CONSTRAINT "voice_sfu_room_canonical" CHECK ("voice_sfu_room"."generation" > 0 and "voice_sfu_room"."room_name" = 'voice:' || "voice_sfu_room"."channel_id"::text || ':' || "voice_sfu_room"."call_id"::text || ':' || "voice_sfu_room"."generation"::text),
	CONSTRAINT "voice_sfu_room_status" CHECK (("voice_sfu_room"."status" = 'active' and "voice_sfu_room"."retired_at" is null) or ("voice_sfu_room"."status" = 'retired' and "voice_sfu_room"."retired_at" is not null)),
	CONSTRAINT "voice_sfu_room_attempts" CHECK ("voice_sfu_room"."attempts" >= 0),
	CONSTRAINT "voice_sfu_room_lease" CHECK (("voice_sfu_room"."lease_token" is null) = ("voice_sfu_room"."lease_until" is null)),
	CONSTRAINT "voice_sfu_room_outcome" CHECK ("voice_sfu_room"."last_outcome" in ('pending', 'current', 'deleted', 'not_found', 'failed', 'unavailable'))
);
--> statement-breakpoint
CREATE INDEX "voice_sfu_room_due_idx" ON "voice_sfu_room" USING btree ("next_attempt_at","room_name");--> statement-breakpoint
CREATE INDEX "voice_sfu_room_call_idx" ON "voice_sfu_room" USING btree ("call_id");--> statement-breakpoint
-- Room identity and terminal retirement are invariants, including operator/native SQL updates.
CREATE FUNCTION public.voice_sfu_room_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF ROW(NEW.room_name, NEW.channel_id, NEW.call_id, NEW.generation) IS DISTINCT FROM
     ROW(OLD.room_name, OLD.channel_id, OLD.call_id, OLD.generation)
     OR (OLD.status = 'retired' AND NEW.status <> 'retired') THEN
    RAISE EXCEPTION 'voice room ownership is immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER voice_sfu_room_guard BEFORE UPDATE ON public.voice_sfu_room
FOR EACH ROW EXECUTE FUNCTION public.voice_sfu_room_guard();
--> statement-breakpoint
-- Call writers already enter Voice first. No late advisory lock, auth write, or recursive call write.
CREATE FUNCTION public.voice_sfu_retire_call_rooms() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(OLD.generation, OLD.status) IS NOT DISTINCT FROM ROW(NEW.generation, NEW.status) THEN
      RETURN NEW;
    END IF;
    UPDATE public.voice_sfu_room SET status = 'retired', retired_at = clock_timestamp(),
      next_attempt_at = clock_timestamp(), lease_token = NULL, lease_until = NULL
      WHERE call_id = OLD.id AND status = 'active'
        AND (NEW.status <> 'active' OR generation <> NEW.generation);
    RETURN NEW;
  END IF;
  UPDATE public.voice_sfu_room SET status = 'retired', retired_at = clock_timestamp(),
    next_attempt_at = clock_timestamp(), lease_token = NULL, lease_until = NULL
    WHERE call_id = OLD.id AND status = 'active';
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER voice_sfu_retire_call_rooms BEFORE UPDATE OF generation, status OR DELETE
ON public.voice_call FOR EACH ROW EXECUTE FUNCTION public.voice_sfu_retire_call_rooms();
