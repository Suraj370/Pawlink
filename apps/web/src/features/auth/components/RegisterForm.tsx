import { useState } from "react"
import { Button } from "@/components/ui/button"
import { toErrorMessage } from "@/lib/api/errors"
import { useRegister } from "../hooks"
import { registerSchema } from "../schemas"

type Props = {
  onSuccess: () => void
}

export function RegisterForm({ onSuccess }: Props) {
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [phone, setPhone] = useState("")
  const [password, setPassword] = useState("")
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const register = useRegister()

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setFieldError(null)
    setSubmitError(null)

    const parsed = registerSchema.safeParse({ name, email, phone, password })
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? "Invalid input")
      return
    }

    try {
      await register.mutateAsync(parsed.data)
      onSuccess()
    } catch (err) {
      setSubmitError(await toErrorMessage(err, "Registration failed"))
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
      <label className="flex flex-col gap-1 text-sm">
        Name
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
          autoComplete="name"
          required
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Email
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
          autoComplete="email"
          required
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Phone
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
          autoComplete="tel"
          required
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded border border-border bg-background px-3 py-2 text-sm"
          autoComplete="new-password"
          required
        />
      </label>
      {(fieldError ?? submitError) && (
        <p role="alert" className="text-sm text-destructive" data-testid="register-error">
          {fieldError ?? submitError}
        </p>
      )}
      <Button type="submit" isDisabled={register.isPending}>
        {register.isPending ? "Creating account…" : "Create account"}
      </Button>
    </form>
  )
}
