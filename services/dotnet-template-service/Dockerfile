FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build

WORKDIR /src

COPY DotnetTemplateService.csproj ./
RUN dotnet restore

COPY . .
RUN dotnet publish DotnetTemplateService.csproj \
  --configuration Release \
  --output /app/publish \
  --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime

WORKDIR /app

ENV ASPNETCORE_URLS=http://+:8080
ENV DOTNET_RUNNING_IN_CONTAINER=true

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/publish .

EXPOSE 8080

ENTRYPOINT ["dotnet", "DotnetTemplateService.dll"]
