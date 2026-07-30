using System.Security.Cryptography;
using System.Text;

namespace GameEngine.Domain.Model;

public static class CanonicalDrawIdentity
{
    public static Guid Create(Guid publishedScheduleId, Guid gameDefinitionId, DateTimeOffset scheduledExecutionAt)
    {
        var input =
            $"draw-instance:v1|{publishedScheduleId:N}|{gameDefinitionId:N}|{scheduledExecutionAt.UtcDateTime:O}";
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(input));
        return new Guid(bytes[..16]);
    }
}
